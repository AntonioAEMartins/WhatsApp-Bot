// whatsapp.api.module.ts
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WhatsAppApiService } from './whatsapp.api.service';
import { WhatsAppApiController } from './whatsapp.api.controller';
@Module({
  imports: [HttpModule],
  providers: [WhatsAppApiService],
  exports: [WhatsAppApiService],
  controllers: [WhatsAppApiController],
})
export class WhatsAppApiModule {}
