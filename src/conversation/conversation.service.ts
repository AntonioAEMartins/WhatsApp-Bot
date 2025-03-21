import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { MongoClient, Db, WithId, ObjectId, ClientSession } from 'mongodb';
import { ClientProvider } from 'src/db/db.module';
import { SimpleResponseDto } from 'src/request/request.dto';
import { ConversationStep } from './dto/conversation.enums';
import { BaseConversationDto, ConversationContextDTO, ConversationDto, CreateConversationDto, MessageDTO } from './dto/conversation.dto';
import { TransactionDTO } from 'src/transaction/dto/transaction.dto';

@Injectable()
export class ConversationService {
    private readonly logger = new Logger(ConversationService.name);
    private readonly mongoClient: MongoClient;
    private readonly timeThreshold = 1 * 60 * 60 * 1000; // 1 hour in milliseconds
    private readonly terminalSteps = [
        ConversationStep.Completed,
        ConversationStep.IncompleteOrder,
        ConversationStep.OrderNotFound,
        ConversationStep.PaymentInvalid,
        ConversationStep.PaymentAssistance,
        ConversationStep.EmptyOrder,
    ];
    constructor(@Inject('DATABASE_CONNECTION') private db: Db, clientProvider: ClientProvider) {
        this.mongoClient = clientProvider.getClient();
    }

    async createConversation(userConversation: CreateConversationDto): Promise<SimpleResponseDto<{ _id: string }>> {
        const conversationData = {
            ...userConversation,
            conversationContext: {
                ...userConversation.conversationContext,
                currentStep: userConversation.conversationContext?.currentStep || ConversationStep.Initial,
                messages: userConversation.conversationContext?.messages || [],
                lastMessage: new Date(),
            },
        };

        const result = await this.db.collection("conversations").insertOne(conversationData);

        return {
            msg: "Conversation created",
            data: { _id: result.insertedId.toString() },
        };
    }



    async getConversation(id: string): Promise<SimpleResponseDto<ConversationDto>> {
        const conversation = await this.db.collection("conversations").findOne({ _id: new ObjectId(id) });

        if (!conversation) {
            throw new HttpException("Conversation not found", HttpStatus.NOT_FOUND);
        }

        return {
            msg: "Conversation found",
            data: conversation as ConversationDto,
        }
    }

    async getActiveConversation(userId: string): Promise<SimpleResponseDto<ConversationDto>> {

        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 86400000); // 1 day ago

        const conversation = await this.db
            .collection<ConversationDto>("conversations")
            .findOne({
                userId,
            }, {
                sort: { updatedAt: -1 },
            });

        // this.logger.debug(`[getActiveConversation] is active conversation: ${conversation ? "true" : "false"}, last message: ${conversation?.conversationContext.lastMessage}`);
        // this.logger.debug(`[getActiveConversation] conversationId: ${conversation?._id}`);

        if (conversation && conversation.conversationContext.lastMessage) {
            const timeDifference = now.getTime() - new Date(conversation.conversationContext.lastMessage).getTime();
            if (timeDifference <= this.timeThreshold) {
                return {
                    msg: "Active conversation found",
                    data: conversation,
                };
            }
        }

        // this.logger.debug(`[getActiveConversation] No active conversation found for user ${userId}`);
        return {
            msg: "No active conversation",
            data: null,
        };
    }

    async getActiveConversationsByOrderId(orderId: number): Promise<SimpleResponseDto<ConversationDto[]>> {

        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 86400000); // 1 dia atrás

        const conversations = await this.db
            .collection<ConversationDto>("conversations")
            .find({
                "conversationContext.paymentDetails.orderId": orderId,
                "conversationContext.currentStep": { $nin: this.terminalSteps },
                "conversationContext.lastMessage": { $gte: oneDayAgo },
            })
            .sort({ "conversationContext.lastMessage": -1 })
            .toArray();

        const activeConversations = conversations.filter(conversation => {
            const lastMessage = conversation.conversationContext.lastMessage;
            if (!lastMessage) return false;
            const timeDifference = now.getTime() - new Date(lastMessage).getTime();
            this.logger.debug(
                `[getActiveConversationsByOrderId] Conversation ID: ${conversation._id}, Time difference: ${timeDifference}, Threshold: ${this.timeThreshold}`
            );
            return timeDifference <= this.timeThreshold;
        });

        if (activeConversations.length > 0) {
            return {
                msg: "Active conversations found",
                data: activeConversations,
            };
        }

        return {
            msg: "No active conversations found",
            data: [],
        };
    }

    async getAllActiveConversations(getIncompleteOrders: boolean = false, getOrderNotFound: boolean = false): Promise<SimpleResponseDto<ConversationDto[]>> {

        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 86400000); // 1 day ago

        // Create a modified terminal steps list if getIncompleteOrders is true
        let stepsToExclude = getIncompleteOrders
            ? this.terminalSteps.filter(step => step !== ConversationStep.IncompleteOrder)
            : this.terminalSteps;

        stepsToExclude = getOrderNotFound
            ? stepsToExclude.filter(step => step !== ConversationStep.OrderNotFound)
            : stepsToExclude;

        const conversations = await this.db
            .collection<ConversationDto>("conversations")
            .find({
                "conversationContext.currentStep": { $nin: stepsToExclude },
                "conversationContext.lastMessage": { $gte: oneDayAgo }
            })
            .sort({ "conversationContext.lastMessage": -1 })
            .toArray();

        const activeConversations = conversations.filter(conversation => {
            const lastMessage = conversation.conversationContext.lastMessage;
            if (!lastMessage) return false;
            const timeDifference = now.getTime() - new Date(lastMessage).getTime();
            // this.logger.debug(`[getAllActiveConversations] Conversation ID: ${conversation._id}, Time difference: ${timeDifference}, Threshold: ${this.timeThreshold}`);
            return timeDifference <= this.timeThreshold;
        });

        if (activeConversations.length > 0) {
            return {
                msg: "Active conversations found",
                data: activeConversations,
            };
        }

        return {
            msg: "No active conversations found",
            data: [],
        };
    }

    async getActiveConversationsWithTransactions(): Promise<SimpleResponseDto<ConversationDto[]>> {
        // First, get all active conversations
        const activeConversationsResponse = await this.getAllActiveConversations(true, true);
        const activeConversations = activeConversationsResponse.data;

        if (activeConversations.length === 0) {
            return {
                msg: "No active conversations found",
                data: [],
            };
        }

        // Get all order IDs from active conversations
        const orderIds = activeConversations
            .filter(conv => conv.orderId)
            .map(conv => conv.orderId);

        // Fetch all transactions for these orders
        const transactions = orderIds.length > 0
            ? await this.db.collection<TransactionDTO>('transactions')
                .find({ orderId: { $in: orderIds } })
                .toArray()
            : [];

        // Create a map of orderId to transaction for quick lookup
        const transactionMap = transactions.reduce((map, transaction) => {
            map[transaction.orderId] = transaction;
            return map;
        }, {});

        // Fetch all orders for these orderIds
        const orders = orderIds.length > 0
            ? await this.db.collection('orders')
                .find({ _id: { $in: orderIds.map(id => new ObjectId(id)) } })
                .toArray()
            : [];

        // Create a map of orderId to order total amount
        const orderAmountMap = orders.reduce((map, order) => {
            map[order._id.toString()] = order.totalAmount;
            return map;
        }, {});

        // Define payment status enum if not imported
        enum PaymentStatus {
            Pending = 'pending',
            Accepted = 'accepted',
            Denied = 'denied',
            Expired = 'expired'
        }

        // Define pre-confirmation steps
        const preConfirmSteps = [
            ConversationStep.Initial,
            ConversationStep.ConfirmOrder,
            ConversationStep.PaymentMethodSelection
        ];

        // Enrich conversations with transaction data
        const enrichedConversations = activeConversations.map(conversation => {
            const result = {
                ...conversation,
                paymentStatus: PaymentStatus.Pending, // Default status
                orderTotalAmount: conversation.orderId ? orderAmountMap[conversation.orderId] : undefined,
                transaction: undefined
            };

            // Determine payment status based on conversation step
            if (preConfirmSteps.includes(conversation.conversationContext.currentStep)) {
                result.paymentStatus = PaymentStatus.Pending;
            } else if (conversation.conversationContext.currentStep === ConversationStep.UserAbandoned) {
                result.paymentStatus = PaymentStatus.Expired;
            } else if (conversation.conversationContext.currentStep === ConversationStep.PIXError) {
                result.paymentStatus = PaymentStatus.Denied;
            }

            // Add transaction info if exists
            if (conversation.orderId && transactionMap[conversation.orderId]) {
                const transaction = transactionMap[conversation.orderId];

                result.transaction = {
                    transactionId: transaction._id.toString(),
                    status: transaction.status,
                    paymentMethod: transaction.paymentMethod,
                    amount: transaction.amountPaid,
                    expectedAmount: transaction.expectedAmount,
                    initiatedAt: transaction.initiatedAt,
                    confirmedAt: transaction.confirmedAt,
                    expiresAt: transaction.expiresAt,
                    ipagTransactionId: transaction.ipagTransactionId
                };

                // Update payment status based on transaction status
                if (transaction.status === PaymentStatus.Accepted) {
                    result.paymentStatus = PaymentStatus.Accepted;
                } else if (
                    transaction.status === PaymentStatus.Denied ||
                    transaction.status === PaymentStatus.Expired
                ) {
                    result.paymentStatus = PaymentStatus.Denied;
                }
            }

            return result;
        });

        return {
            msg: "Active conversations with transaction status",
            data: enrichedConversations,
        };
    }

    async updateConversationContext(id: string, conversationContext: ConversationContextDTO): Promise<SimpleResponseDto<ConversationDto>> {

        const existingConversation = await this.db.collection("conversations").findOne({ _id: new ObjectId(id) });

        if (!existingConversation) {
            throw new HttpException("Conversation not found", HttpStatus.NOT_FOUND);
        }

        const updatedConversationContext = {
            ...existingConversation.conversationContext,
            ...conversationContext,
        };

        const updatedConversation = await this.db.collection("conversations").findOneAndUpdate(
            { _id: new ObjectId(id) },
            {
                $set: {
                    conversationContext: updatedConversationContext,
                    updatedAt: new Date(),
                },
            },
            { returnDocument: "after" }
        );

        return {
            msg: "Conversation updated",
            data: updatedConversation as ConversationDto,
        };
    }

    async updateConversation(
        id: string,
        conversationData: BaseConversationDto,
        options?: { session?: ClientSession }
    ): Promise<SimpleResponseDto<BaseConversationDto>> {
        // Busca a conversa existente utilizando a session (se fornecida)
        const existingConversation = await this.db
            .collection("conversations")
            .findOne({ _id: new ObjectId(id) }, options);

        if (!existingConversation) {
            throw new HttpException("Conversation not found", HttpStatus.NOT_FOUND);
        }

        const updatedConversation = {
            ...existingConversation,
            ...conversationData,
            updatedAt: new Date(),
        };

        // Atualiza a conversa, passando a session se fornecida
        const conversation = await this.db
            .collection("conversations")
            .findOneAndUpdate(
                { _id: new ObjectId(id) },
                { $set: { ...updatedConversation } },
                { returnDocument: "after", ...options }
            );

        return {
            msg: "Conversation updated",
            data: updatedConversation as BaseConversationDto,
        };
    }


    async completeConversation(id: string): Promise<SimpleResponseDto<ConversationDto>> {
        const conversation = await this.db.collection("conversations").findOne({ _id: new ObjectId(id) });

        if (!conversation) {
            throw new HttpException("Conversation not found", HttpStatus.NOT_FOUND);
        }

        const updatedConversation = await this.db.collection("conversations").findOneAndUpdate(
            { _id: new ObjectId(id) },
            {
                $set: {
                    "conversationContext.currentStep": ConversationStep.Completed,
                    updatedAt: new Date(),
                },
            },
            { returnDocument: "after" }
        );

        return {
            msg: "Conversation completed",
            data: updatedConversation as ConversationDto,
        };
    }

    async updateConversationWithErrorStatus(id: string, errorStatus: ConversationStep): Promise<SimpleResponseDto<ConversationDto>> {
        const conversation = await this.db.collection("conversations").findOne({ _id: new ObjectId(id) });

        if (!conversation) {
            throw new HttpException("Conversation not found", HttpStatus.NOT_FOUND);
        }

        const updatedConversation = await this.db.collection("conversations").findOneAndUpdate(
            { _id: new ObjectId(id) },
            {
                $set: {
                    "conversationContext.currentStep": errorStatus,
                    updatedAt: new Date(),
                },
            },
            { returnDocument: "after" }
        );

        return {
            msg: "Conversation updated",
            data: updatedConversation as ConversationDto,
        };
    }

    async addMessage(id: string, message: MessageDTO): Promise<SimpleResponseDto<ConversationDto>> {
        const conversation = await this.db.collection<ConversationDto>("conversations").findOne({ _id: new ObjectId(id) });

        if (!conversation) {
            throw new HttpException("Conversation not found", HttpStatus.NOT_FOUND);
        }

        const updatedConversation = await this.db.collection<ConversationDto>("conversations").findOneAndUpdate(
            { _id: new ObjectId(id) },
            {
                $push: {
                    "conversationContext.messages": message,
                },
                $set: {
                    "conversationContext.lastMessage": new Date(),
                    updatedAt: new Date(),
                },
            },
            { returnDocument: "after" }
        );

        if (!updatedConversation) {
            throw new HttpException("Failed to update conversation", HttpStatus.INTERNAL_SERVER_ERROR);
        }

        return {
            msg: "Message added",
            data: updatedConversation as ConversationDto,
        };
    }

    async addMessages(id: string, messages: MessageDTO[]): Promise<SimpleResponseDto<ConversationDto>> {
        const conversation = await this.db.collection<ConversationDto>("conversations").findOne({ _id: new ObjectId(id) });

        if (!conversation) {
            throw new HttpException("Conversation not found", HttpStatus.NOT_FOUND);
        }

        const updatedConversation = await this.db.collection<ConversationDto>("conversations").findOneAndUpdate(
            { _id: new ObjectId(id) },
            {
                $push: {
                    "conversationContext.messages": { $each: messages }, // Adiciona várias mensagens
                },
                $set: {
                    "conversationContext.lastMessage": new Date(),
                    updatedAt: new Date(),
                },
            },
            { returnDocument: "after" }
        );

        if (!updatedConversation) {
            throw new HttpException("Failed to update conversation", HttpStatus.INTERNAL_SERVER_ERROR);
        }

        return {
            msg: "Messages added",
            data: updatedConversation as ConversationDto,
        };
    }

}