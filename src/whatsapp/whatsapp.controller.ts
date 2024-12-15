// src/whatsapp/whatsapp.controller.ts

import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { Message } from 'whatsapp-web.js';
import { CreateWhatsAppGroupDTO } from './dto/whatsapp.dto';


@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsappService: WhatsAppService) { }


  @HttpCode(200)
  @Post('send/group/:id/message')
  async sendGroupMessage(@Param('id') id: string, @Body("message") message: string) {
    return await this.whatsappService.sendGroupMessage(id, message);
  }

  @HttpCode(200)
  @Post()
  async createGroup(@Body() createGroupData: CreateWhatsAppGroupDTO) {
    return await this.whatsappService.createGroup(createGroupData);
  }

}
