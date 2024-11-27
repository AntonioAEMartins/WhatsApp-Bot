import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { MongoClient, Db, WithId, ObjectId } from 'mongodb';
import { ClientProvider } from 'src/db/db.module';
import { ConversationDto, ConversationStep, CreateConversationDto, MessageDTO, UpdateConversationDto } from './dto/conversation.dto';
import { SimpleResponseDto } from 'src/request/request.dto';

@Injectable()
export class ConversationService {

    private readonly mongoClient: MongoClient;
    constructor(@Inject('DATABASE_CONNECTION') private db: Db, clientProvider: ClientProvider) {
        this.mongoClient = clientProvider.getClient();
    }

    async createConversation(userConversation: CreateConversationDto): Promise<SimpleResponseDto<CreateConversationDto>> {

        const conversationData = {
            ...userConversation,
            conversationContext: {
                currentStep: ConversationStep.Initial,
                messages: [],
                lastMessage: new Date(),
            },
        }

        const conversation = await this.db.collection("conversations").insertOne(conversationData);

        return {
            msg: "Conversation created",
            data: userConversation
        }
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
            // ConversationStep.IncompleteOrder,
            // ConversationStep.OrderNotFound,
            // ConversationStep.PaymentInvalid,
            // ConversationStep.PaymentAssistance,
            // ConversationStep.Feedback,
            // ConversationStep.FeedbackDetail,
        ];

        const timeThreshold = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
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
                if (timeDifference <= timeThreshold) {
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

    async updateConversation(id: string, userConversation: UpdateConversationDto): Promise<SimpleResponseDto<ConversationDto>> {
        const { conversationContext, orderDetails } = userConversation;

        const existingConversation = await this.db.collection("conversations").findOne({ _id: new ObjectId(id) });

        if (!existingConversation) {
            throw new HttpException("Conversation not found", HttpStatus.NOT_FOUND);
        }

        const updatedConversationContext = {
            ...existingConversation.conversationContext,
            ...conversationContext,
        };

        const updatedOrderDetails = {
            ...existingConversation.orderDetails,
            ...orderDetails,
        };

        const updatedConversation = await this.db.collection("conversations").findOneAndUpdate(
            { _id: new ObjectId(id) },
            {
                $set: {
                    conversationContext: updatedConversationContext,
                    orderDetails: updatedOrderDetails,
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
}