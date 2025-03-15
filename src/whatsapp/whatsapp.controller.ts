import { Controller, Get, Post, Query, Body, HttpCode, HttpException, HttpStatus } from '@nestjs/common';
import { WebhookVerificationDto } from './dto/webhook.verification.dto';
import { WebhookNotificationDto, WhatsAppWebhookDto } from './dto/webhook.notification.dto';
import { WhatsAppService } from './whatsapp.service';
import { FlowService } from './flow.service';
import { FlowDataDto } from './dto/flow.dto';

@Controller('whatsapp')
export class WhatsAppController {
  constructor(
    private readonly whatsAppService: WhatsAppService,
    private readonly flowService: FlowService
  ) {}

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
  async handleWebhookNotification(@Body() notification: WebhookNotificationDto | WhatsAppWebhookDto): Promise<string> {
    console.log("WhatsApp Message Webhook Received");
    // console.log('notification', notification);
    try {
      this.whatsAppService.processWebhookNotification(notification);
      return 'OK';
    } catch (error) {
      console.error('Error processing webhook notification:', error);
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Post('flow-webhook')
  @HttpCode(200)
  async handleFlowWebhook(@Body() flowData: FlowDataDto): Promise<string> {
    console.log("WhatsApp Flow Webhook Received");
    // console.log('Flow data received on dedicated endpoint');
    try {
      // Check if this is a direct unencrypted health check
      if (Object.keys(flowData).length === 2 && 
          'version' in flowData && 
          'action' in flowData && 
          flowData['action'] === 'ping') {
        
        // console.log('Direct health check ping received');
        return JSON.stringify({
          data: {
            status: "active"
          }
        });
      }
      
      // Process the flow data and get the encrypted response
      const encryptedResponse = await this.flowService.processFlowData(flowData);
      // console.log('Flow data processed successfully, returning encrypted response');
      
      // Return the encrypted response directly
      return encryptedResponse;
    } catch (error) {
      // console.error('Error processing flow data:', error);
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }
  
  @Post('flow-webhook/health')
  @HttpCode(200)
  async handleDirectHealthCheck(@Body() body: any): Promise<string> {
    // console.log('Direct health check endpoint called', body);
    
    // Check if this is a formal health check format
    if (body && body.action === 'ping' && body.version) {
      // console.log('Formal health check ping received');
    } else {
      // console.log('Generic health check call received');
    }
    
    // Always respond with the standard health check response
    return JSON.stringify({
      data: {
        status: "active"
      }
    });
  }
}
