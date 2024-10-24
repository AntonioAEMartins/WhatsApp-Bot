// src/whatsapp/whatsapp.controller.ts

import { Controller, Get } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';

@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsappService: WhatsAppService) {}

  @Get('status')
  getStatus(): string {
    // You can enhance this method to return actual status from the service
    return 'WhatsApp Client is running.';
  }

  // Additional endpoints can be added here as needed
}
