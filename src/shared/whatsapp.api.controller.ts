import { Controller, Post, Body, HttpStatus, HttpException, Logger, Get, Param, UseInterceptors, UploadedFile } from '@nestjs/common';
import { WhatsAppApiService } from './whatsapp.api.service';
import { ResponseStructureExtended } from 'src/message/message.service';
import { FileInterceptor } from '@nestjs/platform-express';

@Controller('api/whatsapp')
export class WhatsAppApiController {
    private readonly logger = new Logger(WhatsAppApiController.name);

    constructor(private readonly whatsappApiService: WhatsAppApiService) { }

    @Post('send-message')
    async sendMessage(@Body() message: ResponseStructureExtended) {
        try {
            const result = await this.whatsappApiService.sendWhatsAppMessage(message);
            return { success: true, data: result };
        } catch (error) {
            this.logger.error(`Error sending WhatsApp message: ${error.message}`);
            throw new HttpException(
                error.message || 'Failed to send WhatsApp message',
                error.status || HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Post('send-messages')
    async sendMessages(@Body() messages: ResponseStructureExtended[]) {
        try {
            const results = await this.whatsappApiService.sendWhatsAppMessages(messages);
            return { success: true, data: results };
        } catch (error) {
            this.logger.error(`Error sending WhatsApp messages: ${error.message}`);
            throw new HttpException(
                error.message || 'Failed to send WhatsApp messages',
                error.status || HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Post('upload-media')
    @UseInterceptors(FileInterceptor('file'))
    async uploadMedia(@UploadedFile() file: Express.Multer.File) {
        try {
            const mediaId = await this.whatsappApiService.uploadMedia(file.buffer, file.mimetype);
            return { success: true, mediaId };
        } catch (error) {
            this.logger.error(`Error uploading media: ${error.message}`);
            throw new HttpException(
                error.message || 'Failed to upload media',
                error.status || HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }

    @Get('media/:mediaId')
    async getMediaUrl(@Param('mediaId') mediaId: string) {
        try {
            const url = await this.whatsappApiService.retrieveMediaUrl(mediaId);
            return { success: true, url };
        } catch (error) {
            this.logger.error(`Error retrieving media URL: ${error.message}`);
            throw new HttpException(
                error.message || 'Failed to retrieve media URL',
                error.status || HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }
}
