import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { MongoClient, Db, WithId, ObjectId, ClientSession } from 'mongodb';
import { ClientProvider } from 'src/db/db.module';
import { SimpleResponseDto } from 'src/request/request.dto';
import { ConversationStep } from './dto/conversation.enums';
import { BaseConversationDto, ConversationContextDTO, ConversationDto, CreateConversationDto, MessageDTO } from './dto/conversation.dto';

@Injectable()
export class ConversationService {

    private readonly mongoClient: MongoClient;
    private readonly timeThreshold = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
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
        const terminalSteps = [
            ConversationStep.Completed,
            ConversationStep.IncompleteOrder,
            ConversationStep.OrderNotFound,
            ConversationStep.PaymentInvalid,
            ConversationStep.PaymentAssistance,
            // ConversationStep.Feedback,
            // ConversationStep.FeedbackDetail,
        ];

        const now = new Date();

        const conversation = await this.db
            .collection<ConversationDto>("conversations")
            .find({ userId: userId })
            .sort({ "conversationContext.lastMessage": -1 })
            .limit(1)
            .next();

        if (conversation) {
            const currentStep = conversation.conversationContext.currentStep;
            const lastMessage = conversation.conversationContext.lastMessage;

            if (!terminalSteps.includes(currentStep) && lastMessage) {
                const timeDifference = now.getTime() - new Date(lastMessage).getTime();
                if (timeDifference <= this.timeThreshold) {
                    return {
                        msg: "Active conversation found",
                        data: conversation,
                    };
                }
            }
        }

        return {
            msg: "No active conversation",
            data: null,
        };
    }

    async getActiveConversationsByOrderId(orderId: number): Promise<SimpleResponseDto<ConversationDto[]>> {
        const terminalSteps = [
            ConversationStep.Completed,
        ];

        const now = new Date();

        // Busca todas as conversas relacionadas ao orderId
        const conversations = await this.db
            .collection<ConversationDto>("conversations")
            .find({
                "conversationContext.paymentDetails.orderId": orderId,
                "conversationContext.currentStep": { $nin: terminalSteps },
                "conversationContext.lastMessage": { $gte: new Date(now.getTime() - this.timeThreshold) },
            })
            .toArray();

        if (conversations && conversations.length > 0) {
            return {
                msg: "Active conversations found",
                data: conversations,
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