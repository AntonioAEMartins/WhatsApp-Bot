import { Module } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';
import { TableModule } from 'src/table/table.module';
import { LangchainModule } from 'src/langchain/langchain.module';
import { UserModule } from 'src/user/user.module';
import { ConversationModule } from 'src/conversation/conversation.module';
import { OrderModule } from 'src/order/order.module';
import { TransactionModule } from 'src/transaction/transaction.module';
import { WhatsAppUtils } from './whatsapp.utils';
import { PaymentProcessor } from './payment.processor';
import { BullModule } from '@nestjs/bull';
import { DatabaseModule } from 'src/db/db.module';
import { IPagModule } from 'src/payment-gateway/ipag.module';
import { ScheduleModule } from '@nestjs/schedule';
@Module({
  imports: [
    TableModule, LangchainModule, UserModule, ConversationModule,
    OrderModule, TransactionModule, DatabaseModule, IPagModule,
    BullModule.forRoot({
      redis: {
        host: 'localhost',
        port: 6379,
      },
    }),
    BullModule.registerQueue({
      name: 'payment',
    }),
  ],
  providers: [WhatsAppService, WhatsAppUtils, PaymentProcessor],
  controllers: [WhatsAppController],
  exports: [WhatsAppUtils, WhatsAppService],
})
export class WhatsAppModule { }