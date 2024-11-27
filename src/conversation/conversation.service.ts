import { Inject, Injectable } from '@nestjs/common';
import { MongoClient, Db } from 'mongodb';
import { ClientProvider } from 'src/db/db.module';
import { CreateConversationDto } from './dto/conversation.dto';
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
            lastMessage: new Date()
        }

        const conversation = await this.db.collection("conversations").insertOne(conversationData);

        return {
            msg: "Conversation created",
            data: userConversation
        }
    }

}
