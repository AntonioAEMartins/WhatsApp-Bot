// src/whatsapp/whatsapp.controller.ts

import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { RequestStructure, ResponseStructure, WhatsAppService } from './whatsapp.service';


@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsappService: WhatsAppService) { }

  @HttpCode(200)
  @Post('message')
  async receiveMessage(@Body() request: RequestStructure) : Promise<ResponseStructure[]> {
    return await this.whatsappService.handleProcessMessage(request);
  }

}
