import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ConversationService } from './conversation.service';
import { BaseConversationDto, ConversationContextDTO, ConversationDto, CreateConversationDto, MessageDTO } from './dto/conversation.dto';
import { SimpleResponseDto } from 'src/request/request.dto';

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
        if (!userId) {
            throw new HttpException("User ID is required", HttpStatus.BAD_REQUEST);
        }
        return await this.conversationService.getActiveConversation(userId);
    }

    @HttpCode(HttpStatus.OK)
    @Get('active_by_order')
    async getActiveConversationsByOrderId(@Query('orderId') orderId: string) {
        if (!orderId) {
            throw new HttpException("Order ID is required", HttpStatus.BAD_REQUEST);
        }

        const numericOrderId = parseInt(orderId, 10);
        if (isNaN(numericOrderId)) {
            throw new HttpException("Order ID must be a valid number", HttpStatus.BAD_REQUEST);
        }

        return await this.conversationService.getActiveConversationsByOrderId(numericOrderId);
    }

    @HttpCode(HttpStatus.OK)
    @Get('active-conversations')
    async getActiveConversations(): Promise<SimpleResponseDto<ConversationDto[]>> {
        return this.conversationService.getActiveConversationsWithTransactions();
    }

    @HttpCode(HttpStatus.OK)
    @Post(":id/completed")
    async completeConversation(@Param('id') id: string) {
        return await this.conversationService.completeConversation(id);
    }

    @HttpCode(HttpStatus.OK)
    @Put(':id/context')
    async updateConversationContext(@Param('id') id: string, @Body() conversationContext: ConversationContextDTO) {
        return await this.conversationService.updateConversationContext(id, conversationContext);
    }

    @HttpCode(HttpStatus.OK)
    @Put(':id')
    async updateConversation(@Param('id') id: string, @Body() conversationData: BaseConversationDto) {
        return await this.conversationService.updateConversation(id, conversationData);
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