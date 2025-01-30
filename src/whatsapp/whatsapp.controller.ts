// src/whatsapp/whatsapp.controller.ts

import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { RequestStructure, WhatsAppService } from './whatsapp.service';
import { Message } from 'whatsapp-web.js';
import { CreateWhatsAppGroupDTO } from './dto/whatsapp.dto';


@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsappService: WhatsAppService) { }

  @HttpCode(200)
  @Post()
  async receiveMessage(@Body() request: RequestStructure) {
    return await this.whatsappService.handleProcessMessage(request);
  }

}
