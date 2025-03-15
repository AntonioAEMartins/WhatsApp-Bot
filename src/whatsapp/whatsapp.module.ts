import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { MessageModule } from 'src/message/message.module';
import { HttpModule } from '@nestjs/axios';
import { WhatsAppApiModule } from 'src/shared/whatsapp-api/whatsapp.api.module';
import { WhatsAppCertificationService } from './whatsapp.certification.service';
import { WhatsAppCertificationController } from './whatsapp.certification.controller';
import { FlowService } from './flow.service';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => MessageModule),
    HttpModule,
    WhatsAppApiModule,
  ],
  controllers: [WhatsAppController, WhatsAppCertificationController],
  providers: [WhatsAppService, WhatsAppCertificationService, FlowService],
  exports: [WhatsAppService, WhatsAppCertificationService, FlowService],
})
export class WhatsAppModule { }