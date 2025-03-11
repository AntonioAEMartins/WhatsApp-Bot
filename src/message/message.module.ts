import { Module } from '@nestjs/common';
import { MessageService } from './message.service';
import { MessageController } from './message.controller';
import { TableModule } from 'src/table/table.module';
import { LangchainModule } from 'src/langchain/langchain.module';
import { UserModule } from 'src/user/user.module';
import { ConversationModule } from 'src/conversation/conversation.module';
import { OrderModule } from 'src/order/order.module';
import { TransactionModule } from 'src/transaction/transaction.module';
import { MessageProcessor } from './message.processor';
import { BullModule } from '@nestjs/bull';
import { DatabaseModule } from 'src/db/db.module';
import { IPagModule } from 'src/payment-gateway/ipag.module';
import { CardModule } from 'src/card/card.module';
import { GenReceiptModule } from 'src/gen-receipt/gen.receipt.module';
import { MessageUtils } from './message.utils';
import { PaymentProcessor } from './payment.processor';
import { WhatsAppApiModule } from 'src/shared/whatsapp.api.module';

@Module({
  imports: [
    TableModule, LangchainModule, UserModule, ConversationModule,
    OrderModule, TransactionModule, DatabaseModule, IPagModule, CardModule,
    BullModule.forRoot({
      redis: {
        host: 'localhost',
        port: 6379,
      },
    }),
    BullModule.registerQueue({
      name: 'payment',
    }),
    GenReceiptModule,
    WhatsAppApiModule
  ],
  providers: [MessageService, MessageUtils, PaymentProcessor],
  controllers: [MessageController],
  exports: [MessageUtils, MessageService],
})
export class MessageModule { }