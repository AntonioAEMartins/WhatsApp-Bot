import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { MongoClient, Db, WithId, ObjectId, ClientSession } from 'mongodb';
import { ClientProvider } from 'src/db/db.module';
import { SimpleResponseDto } from 'src/request/request.dto';
import { ConversationStep } from './dto/conversation.enums';
import { BaseConversationDto, ConversationContextDTO, ConversationDto, CreateConversationDto, MessageDTO } from './dto/conversation.dto';

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

    async getAllActiveConversations(): Promise<SimpleResponseDto<ConversationDto[]>> {

        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 86400000); // 1 day ago

        const conversations = await this.db
            .collection<ConversationDto>("conversations")
            .find({
                "conversationContext.currentStep": { $nin: this.terminalSteps },
                "conversationContext.lastMessage": { $gte: oneDayAgo },
            })
            .sort({ "conversationContext.lastMessage": -1 })
            .toArray();

        const activeConversations = conversations.filter(conversation => {
            const lastMessage = conversation.conversationContext.lastMessage;
            if (!lastMessage) return false;
            const timeDifference = now.getTime() - new Date(lastMessage).getTime();
            this.logger.debug(`[getAllActiveConversations] Conversation ID: ${conversation._id}, Time difference: ${timeDifference}, Threshold: ${this.timeThreshold}`);
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