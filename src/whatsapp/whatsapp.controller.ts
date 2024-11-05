// src/whatsapp/whatsapp.controller.ts

import { Controller, Get } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { Message } from 'whatsapp-web.js';


@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsappService: WhatsAppService) { }

}
