import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { MessageModule } from 'src/message/message.module';
import { HttpModule } from '@nestjs/axios';
import { WhatsAppApiModule } from 'src/shared/whatsapp-api/whatsapp.api.module';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => MessageModule),
    HttpModule,
    WhatsAppApiModule,
  ],
  controllers: [WhatsAppController],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class WhatsAppModule { }