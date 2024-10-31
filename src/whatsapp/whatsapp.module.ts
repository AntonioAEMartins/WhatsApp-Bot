// src/whatsapp/whatsapp.module.ts

import { Module } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';
import { TableModule } from 'src/table/table.module';

@Module({
  imports: [TableModule],
  providers: [WhatsAppService],
  controllers: [WhatsAppController],
})
export class WhatsAppModule {}
