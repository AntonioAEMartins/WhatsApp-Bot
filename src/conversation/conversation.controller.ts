import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { CreateConversationDto, MessageDTO, UpdateConversationDto } from './dto/conversation.dto';

@Controller('conversation')
export class ConversationController {
    constructor(private readonly conversationService: ConversationService) { }

    @HttpCode(HttpStatus.CREATED)
    @Post()
    async createConversation(@Body() userConversation: CreateConversationDto) {
        return await this.conversationService.createConversation(userConversation);
    }

    @HttpCode(HttpStatus.OK)
    @Post(":id/messages")
    async addMessage(@Param('id') id: string, @Body() message: MessageDTO) {
        return await this.conversationService.addMessage(id, message);
    }

    @HttpCode(HttpStatus.OK)
    @Get('active')
    async getActiveConversation(@Query('userId') userId: string) {
        if (!userId){
            throw new HttpException("User ID is required", HttpStatus.BAD_REQUEST);
        }
        return await this.conversationService.getActiveConversation(userId);
    }

    @HttpCode(HttpStatus.OK)
    @Post(":id/completed")
    async completeConversation(@Param('id') id: string) {
        return await this.conversationService.completeConversation(id);
    }

    @HttpCode(HttpStatus.OK)
    @Put(':id')
    async updateConversation(@Param('id') id: string, @Body() userConversation: UpdateConversationDto) {
        return await this.conversationService.updateConversation(id, userConversation);
    }

    @HttpCode(HttpStatus.OK)
    @Get(':id')
    async getConversation(@Param('id') id: string) {
        return await this.conversationService.getConversation(id);
    }
}

// 5. Add Payment Proof or Other Media
// Endpoint: POST /conversation/:id/media

// Purpose:

// Handles the uploading and association of media files (e.g., payment proofs) with a conversation.
// Stores media metadata and links in the conversation's context.
// Usage in Flow:

// When a user sends a payment proof or other media, the chatbot processes it and uses this endpoint to store the information.
// Updates the paymentProofs array in the conversationContext.