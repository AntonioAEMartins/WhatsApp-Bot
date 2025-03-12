import { Controller, Get, Post, Query, Body, HttpCode, HttpException, HttpStatus } from '@nestjs/common';
import { WebhookVerificationDto } from './dto/webhook.verification.dto';
import { WebhookNotificationDto } from './dto/webhook.notification.dto';
import { WhatsAppService } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsAppService: WhatsAppService) {}

  @Get('webhook')
  @HttpCode(200)
  async verifyWebhook(@Query() query: WebhookVerificationDto): Promise<string> {
    try {
      return this.whatsAppService.handleWebhookVerification(query);
    } catch (error) {
      throw new HttpException(error.message, HttpStatus.FORBIDDEN);
    }
  }

  @Post('webhook')
  @HttpCode(200)
  async handleWebhookNotification(@Body() notification: WebhookNotificationDto): Promise<string> {
    // console.log('notification', notification);
    try {
      this.whatsAppService.processWebhookNotification(notification);
      return 'OK';
    } catch (error) {
      console.error('Error processing webhook notification:', error);
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }
}
