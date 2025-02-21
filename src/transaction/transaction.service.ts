import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { MongoClient, Db, ObjectId, ClientSession } from 'mongodb';
import { ClientProvider } from 'src/db/db.module';
import { SimpleResponseDto } from 'src/request/request.dto';
import { CreateTransactionDTO, ErrorDescriptionDTO, PaymentMethod, TransactionDTO } from './dto/transaction.dto';
import { ActivePaymentStatuses, PaymentDescription, PaymentStatus } from 'src/conversation/dto/conversation.enums';
import { ConversationDto } from 'src/conversation/dto/conversation.dto';

@Injectable()
export class TransactionService {

    private readonly mongoClient: MongoClient;
    private readonly timeThreshold = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
    constructor(
        @Inject('DATABASE_CONNECTION') private db: Db, clientProvider: ClientProvider,
    ) {
        this.mongoClient = clientProvider.getClient();
    }

    async createTransaction(createTransactionData: CreateTransactionDTO): Promise<SimpleResponseDto<TransactionDTO>> {
        const transactionData: TransactionDTO = {
            _id: new ObjectId(),
            ...createTransactionData,
            createdAt: new Date(),
            updatedAt: new Date(),
        }

        const transaction = await this.db.collection("transactions").insertOne(transactionData);

        return {
            msg: "Transaction created",
            data: transactionData
        }
    }

    async getSummaryWithDuplicateInfo(
        id: string
    ): Promise<SimpleResponseDto<{
        wasDuplicated: boolean;
        duplicatedTransactionId: string;
        expectedAmount: number;
        documentNumber: string;
        status: string;
    }>> {
        // Validate that the ID is a 24-character hexadecimal string.
        if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
            throw new HttpException(
                "Transaction ID must be a valid 24-character hex string",
                HttpStatus.BAD_REQUEST
            );
        }

        // Retrieve the original transaction.
        const transaction = (await this.db
            .collection("transactions")
            .findOne({ _id: new ObjectId(id) })) as TransactionDTO;

        if (!transaction) {
            throw new HttpException("Transaction not found", HttpStatus.NOT_FOUND);
        }

        // Retrieve the conversation linked to the transaction.
        const conversation = (await this.db
            .collection("conversations")
            .findOne({ _id: new ObjectId(transaction.conversationId) })) as ConversationDto;

        if (!conversation) {
            throw new HttpException("Conversation not found", HttpStatus.NOT_FOUND);
        }

        // Check for a duplicated transaction:
        // Find a transaction with the same orderId and conversationId that is still pending.
        let wasDuplicated = false;
        let duplicateTransactionId = "";
        try {
            const pendingTransaction = await this.db
                .collection("transactions")
                .findOne({
                    orderId: transaction.orderId,
                    conversationId: transaction.conversationId,
                    status: PaymentStatus.Pending,
                    _id: { $ne: transaction._id }
                });

            if (pendingTransaction) {
                wasDuplicated = true;
                duplicateTransactionId = pendingTransaction._id.toString();
            }
        } catch (error) {
            // Optionally log the error if needed.
        }

        // Return the unified summary.
        return {
            msg: "Transaction found",
            data: {
                wasDuplicated,
                duplicatedTransactionId: duplicateTransactionId,
                expectedAmount: transaction.expectedAmount,
                documentNumber: conversation.conversationContext.documentNumber,
                status: transaction.status,
            },
        };
    }


    async getReceipt(id: string): Promise<SimpleResponseDto<TransactionDTO>> {
        const results = await this.db.collection("transactions").aggregate([
            {
                $match: { _id: new ObjectId(id) }
            },
            {
                $lookup: {
                    from: "cards",
                    let: { cardIdStr: "$cardId" },
                    pipeline: [
                        {
                            $match: {
                                $expr: { $eq: ["$_id", { $toObjectId: "$$cardIdStr" }] }
                            }
                        },
                        {
                            $project: { last4: 1, _id: 0 }
                        }
                    ],
                    as: "cardInfo"
                }
            },
            {
                $addFields: {
                    cardLast4: { $arrayElemAt: ["$cardInfo.last4", 0] }
                }
            },
            {
                $project: {
                    _id: 1,
                    table_id: "$tableId",
                    amountPaid: 1,
                    status: 1,
                    confirmedAt: 1,
                    cardLast4: 1
                }
            }
        ]).toArray();

        if (!results || results.length === 0) {
            throw new HttpException("Transaction not found", HttpStatus.NOT_FOUND);
        }

        return {
            msg: "Transaction found",
            data: results[0] as TransactionDTO,
        };
    }


    async getTransactionStatus(transactionId: string): Promise<SimpleResponseDto<{
        status: PaymentStatus;
        errorDescription?: ErrorDescriptionDTO;
    }>> {
        const transaction = await this.db.collection("transactions").findOne({ _id: new ObjectId(transactionId) });

        if (!transaction) {
            throw new HttpException("Transaction not found", HttpStatus.NOT_FOUND);
        }

        let transactionStatus = transaction.status;
        if (transaction.status === PaymentStatus.PreAuthorized) {
            transactionStatus = PaymentStatus.Pending;
        } else if (transaction.status === PaymentStatus.Waiting) {
            transactionStatus = PaymentStatus.Pending;
        } else if (transaction.status === PaymentStatus.Created) {
            transactionStatus = PaymentStatus.Pending;
        }

        return {
            msg: "Transaction status found",
            data: {
                status: transactionStatus,
                errorDescription: transaction.errorDescription,
            },
        }
    }



    async getExpiredPIXTransactions(): Promise<SimpleResponseDto<TransactionDTO[]>> {
        const now = new Date(); // Data e hora atual

        const expiredTransactions = await this.db.collection("transactions").find({
            status: PaymentStatus.Pending, // Apenas transações pendentes
            paymentMethod: PaymentMethod.PIX, // Apenas pagamentos via PIX
            expiresAt: { $lt: now } // Verifica se a expiração já passou
        }).toArray();

        return {
            msg: "Expired PIX transactions found",
            data: expiredTransactions as TransactionDTO[],
        };
    }


    async getTransactionByipagTransactionId(ipagTransactionId: string): Promise<SimpleResponseDto<TransactionDTO>> {
        const transaction = await this.db.collection("transactions").findOne({ ipagTransactionId });

        if (!transaction) {
            throw new HttpException("Transaction not found", HttpStatus.NOT_FOUND);
        }

        return {
            msg: "Transaction found",
            data: transaction as TransactionDTO,
        }
    }

    async getPendingTransactionsOlderThan(olderThanMinutes: number, youngerThanMinutes: number, statuses?: PaymentStatus[]): Promise<SimpleResponseDto<TransactionDTO[]>> {
        const now = new Date();
        const olderThanThreshold = new Date(now.getTime() - olderThanMinutes * 60 * 1000);
        const youngerThanThreshold = new Date(now.getTime() - youngerThanMinutes * 60 * 1000);

        const transactions = await this.db.collection("transactions").find({
            status: { $in: statuses || [PaymentStatus.Pending, PaymentStatus.Waiting, PaymentStatus.Created] },
            createdAt: { $gt: olderThanThreshold, $lt: youngerThanThreshold }
        }).toArray();

        return {
            msg: "Pending transactions found",
            data: transactions as TransactionDTO[],
        };
    }

    async updateTransaction(
        id: string,
        updateTransactionData: Partial<TransactionDTO>,
        options?: { session?: ClientSession }
    ): Promise<SimpleResponseDto<TransactionDTO>> {
        // Busca a transação existente utilizando a session (se fornecida)
        const transaction = await this.db
            .collection("transactions")
            .findOne({ _id: new ObjectId(id) }, options);

        if (!transaction) {
            throw new HttpException("Transaction not found", HttpStatus.NOT_FOUND);
        }

        // Atualiza a transação, passando a session se fornecida
        const updatedTransaction = await this.db
            .collection("transactions")
            .findOneAndUpdate(
                { _id: new ObjectId(id) },
                { $set: { ...updateTransactionData, updatedAt: new Date() } },
                { returnDocument: "after", ...options }
            );

        return {
            msg: "Transaction updated",
            data: updatedTransaction.value as TransactionDTO,
        };
    }

    async getTransaction(id: string): Promise<SimpleResponseDto<TransactionDTO>> {
        const transaction = await this.db.collection("transactions").findOne({ _id: new ObjectId(id) });

        if (!transaction) {
            throw new HttpException("Transaction not found", HttpStatus.NOT_FOUND);
        }

        return {
            msg: "Transaction found",
            data: transaction as TransactionDTO,
        }
    }

    async getActiveTransactionsByOrderId(orderId: string): Promise<SimpleResponseDto<TransactionDTO[]>> {
        // Busca as transações com `orderId` e um `status` que esteja em `activeStatuses`
        const transactions = await this.db.collection("transactions").find({
            orderId,
            status: { $in: ActivePaymentStatuses },
        }).toArray();

        return {
            msg: "Active transactions found",
            data: transactions as TransactionDTO[],
        };
    }

    async getTotalPaidByOrderId(orderId: string): Promise<SimpleResponseDto<{ totalPaid: number }>> {
        // Defina os status considerados para calcular o total pago
        const paymentStatusesToConsider = [PaymentStatus.Accepted, PaymentStatus.Denied];

        // Busca as transações com os status definidos
        const transactions = await this.db.collection("transactions").find({
            orderId,
            status: { $in: paymentStatusesToConsider },
        }).toArray();

        // Soma os valores pagos de todas as transações
        const totalPaid = transactions.reduce((sum, transaction) => sum + (transaction.amountPaid || 0), 0);

        return {
            msg: "Total paid calculated",
            data: { totalPaid },
        };
    }

    async getTotalPaidByUserAndOrderId(userId: string, orderId: string): Promise<SimpleResponseDto<{ totalPaid: number }>> {
        // Defina os status considerados para calcular o total pago
        const paymentStatusesToConsider = [PaymentStatus.Accepted, PaymentStatus.Denied];

        // Busca as transações com os status definidos, filtrando também pelo userId
        const transactions = await this.db.collection("transactions").find({
            userId,
            orderId,
            status: { $in: paymentStatusesToConsider },
        }).toArray();

        // Soma os valores pagos de todas as transações
        const totalPaid = transactions.reduce((sum, transaction) => sum + (transaction.amountPaid || 0), 0);

        return {
            msg: "Total paid calculated for user and order",
            data: { totalPaid },
        };
    }

    async getActiveTransactionsByUserId(userId: string): Promise<SimpleResponseDto<TransactionDTO[]>> {
        // Busca as transações com `orderId` e um `status` que esteja em `activeStatuses`
        const transactions = await this.db.collection("transactions").find({
            userId,
            status: { $in: ActivePaymentStatuses },
        }).toArray();

        return {
            msg: "Active transactions found",
            data: transactions as TransactionDTO[],
        };
    }

    async getLastActiveTransactionByUserId(userId: string): Promise<SimpleResponseDto<TransactionDTO>> {
        // Busca a transação ativa mais recente para o usuário
        const transaction = await this.db.collection("transactions").findOne(
            {
                userId,
                status: { $in: ActivePaymentStatuses },
            },
            {
                sort: { createdAt: -1 },
            }
        );

        if (!transaction) {
            throw new HttpException("No active transaction found", HttpStatus.NOT_FOUND);
        }

        return {
            msg: "Last active transaction found",
            data: transaction as TransactionDTO,
        };
    }

    async completeTransaction(id: string): Promise<SimpleResponseDto<TransactionDTO>> {
        const transaction = await this.db.collection("transactions").findOne({ _id: new ObjectId(id) });

        if (!transaction) {
            throw new HttpException("Transaction not found", HttpStatus.NOT_FOUND);
        }

        if (transaction.status !== PaymentStatus.Pending) {
            throw new HttpException("Transaction is not pending", HttpStatus.BAD_REQUEST);
        }

        const updatedTransaction = await this.db.collection("transactions").findOneAndUpdate(
            { _id: new ObjectId(id) },
            { $set: { status: PaymentStatus.Accepted, confirmedAt: new Date() } },
            { returnDocument: "after" }
        );

        return {
            msg: "Transaction completed",
            data: updatedTransaction.value as TransactionDTO,
        }
    }

    async isPaymentProofTransactionIdDuplicate(userId: string, transactionIdToCheck: string): Promise<boolean> {
        const transaction = await this.db.collection("transactions").findOne({
            userId,
            paymentProofs: { $elemMatch: { id_transacao: transactionIdToCheck } }
        });

        return !!transaction;
    }

    async changeTransactionStatusToConfirmed(transactionId: string): Promise<SimpleResponseDto<TransactionDTO>> {
        const transaction = await this.db.collection("transactions").findOne({ _id: new ObjectId(transactionId) });

        if (!transaction) {
            throw new HttpException("Transaction not found", HttpStatus.NOT_FOUND);
        }

        // Construção da descrição com base no estado atual
        let description = '';
        switch (transaction.status) {
            case PaymentStatus.Denied:
                description = PaymentDescription.Failed;
                break;
            default:
                description = 'Confirmed without additional context'; // Caso o status não seja mapeado
                break;
        }

        const updatedTransaction = await this.db.collection("transactions").findOneAndUpdate(
            { _id: new ObjectId(transactionId) },
            {
                $set: {
                    status: PaymentStatus.Accepted,
                    confirmedAt: new Date(),
                    description: description,
                }
            },
            { returnDocument: "after" }
        );

        return {
            msg: "Transaction status changed to confirmed",
            data: updatedTransaction.value as TransactionDTO,
        };
    }

    async duplicateTransaction(
        transactionId: string
    ): Promise<SimpleResponseDto<{ transactionId: string }>> {
        try {
            const transactionObjectId = new ObjectId(transactionId);

            const originalTransaction = await this.db
                .collection("transactions")
                .findOne({ _id: transactionObjectId });


            if (!originalTransaction) {
                throw new HttpException("Transaction not found", HttpStatus.NOT_FOUND);
            }

            const { _id, ...transactionData } = originalTransaction;

            const now = new Date();
            transactionData.createdAt = now;
            transactionData.updatedAt = now;
            transactionData.status = PaymentStatus.Pending;

            const newTransactionId = new ObjectId();

            const newTransaction = { _id: newTransactionId, ...transactionData };

            await this.db.collection("transactions").insertOne(newTransaction);

            return {
                msg: "Duplicated transaction created",
                data: { transactionId: newTransactionId.toString() },
            };
        } catch (error) {
            if (error instanceof HttpException) {
                throw error;
            }
            throw new HttpException(
                "Error duplicating transaction",
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }
}