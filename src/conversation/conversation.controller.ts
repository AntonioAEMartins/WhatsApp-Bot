import { Body, Controller, Post } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { CreateConversationDto } from './dto/conversation.dto';

@Controller('conversation')
export class ConversationController {
    constructor(private readonly conversationService: ConversationService) { }

    @Post()
    async createConversation(@Body() userConversation: CreateConversationDto) {
        return await this.conversationService.createConversation(userConversation);
    }

}
