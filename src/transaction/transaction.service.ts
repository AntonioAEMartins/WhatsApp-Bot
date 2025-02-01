import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { MongoClient, Db, WithId, ObjectId } from 'mongodb';
import { ClientProvider } from 'src/db/db.module';
import { SimpleResponseDto } from 'src/request/request.dto';
import { CreateTransactionDTO, TransactionDTO } from './dto/transaction.dto';
import { ActivePaymentStatuses, PaymentDescription, PaymentStatus } from 'src/conversation/dto/conversation.enums';
@Injectable()
export class TransactionService {

    private readonly mongoClient: MongoClient;
    private readonly timeThreshold = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
    constructor(@Inject('DATABASE_CONNECTION') private db: Db, clientProvider: ClientProvider) {
        this.mongoClient = clientProvider.getClient();
    }

    async createTransaction(createTransactionData: CreateTransactionDTO): Promise<SimpleResponseDto<CreateTransactionDTO>> {
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

    async updateTransaction(id: string, updateTransactionData: Partial<TransactionDTO>): Promise<SimpleResponseDto<TransactionDTO>> {
        const transaction = await this.db.collection("transactions").findOne({ _id: new ObjectId(id) });

        if (!transaction) {
            throw new HttpException("Transaction not found", HttpStatus.NOT_FOUND);
        }

        const updatedTransaction = await this.db.collection("transactions").findOneAndUpdate(
            { _id: new ObjectId(id) },
            { $set: { ...updateTransactionData, updatedAt: new Date() } },
            { returnDocument: "after" }
        );

        return {
            msg: "Transaction updated",
            data: updatedTransaction.value as TransactionDTO,
        }
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
        const paymentStatusesToConsider = [PaymentStatus.Confirmed, PaymentStatus.Overpaid, PaymentStatus.Underpaid];
    
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
        const paymentStatusesToConsider = [PaymentStatus.Confirmed, PaymentStatus.Overpaid, PaymentStatus.Underpaid];
        
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
            { $set: { status: PaymentStatus.Confirmed, confirmedAt: new Date() } },
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

    async getLastOverpaidTransactionByUserAndOrder(userId: string, orderId: string): Promise<SimpleResponseDto<TransactionDTO>> {
        const transactions = await this.db.collection("transactions").findOne(
            {
                userId,
                orderId,
                status: PaymentStatus.Overpaid,
            },
            {
                sort: { createdAt: -1 },
            }
        )

        return {
            msg: "Last overpaid transaction found",
            data: transactions as TransactionDTO,
        };
    }

    async getLastUnderpaidTransactionByUserAndOrder(userId: string, orderId: string): Promise<SimpleResponseDto<TransactionDTO>> {
        const transactions = await this.db.collection("transactions").findOne(
            {
                userId: userId,
                orderId: orderId,
                status: PaymentStatus.Underpaid,
            },
            {
                sort: { createdAt: -1 },
            }
        )

        return {
            msg: "Last underpaid transaction found",
            data: transactions as TransactionDTO,
        };
    }

    async changeTransactionStatusToConfirmed(transactionId: string): Promise<SimpleResponseDto<TransactionDTO>> {
        const transaction = await this.db.collection("transactions").findOne({ _id: new ObjectId(transactionId) });

        if (!transaction) {
            throw new HttpException("Transaction not found", HttpStatus.NOT_FOUND);
        }

        // Construção da descrição com base no estado atual
        let description = '';
        switch (transaction.status) {
            case PaymentStatus.Overpaid:
                description = PaymentDescription.Overpaid;
                break;
            case PaymentStatus.Underpaid:
                description = PaymentDescription.Underpaid;
                break;
            case PaymentStatus.Partial:
                description = PaymentDescription.Partial;
                break;
            case PaymentStatus.Incomplete:
                description = PaymentDescription.Incomplete;
                break;
            default:
                description = 'Confirmed without additional context'; // Caso o status não seja mapeado
        }

        const updatedTransaction = await this.db.collection("transactions").findOneAndUpdate(
            { _id: new ObjectId(transactionId) },
            {
                $set: {
                    status: PaymentStatus.Confirmed,
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



}