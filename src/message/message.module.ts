import { forwardRef, Module } from '@nestjs/common';
import { MessageService } from './message.service';
import { MessageController } from './message.controller';
import { TableModule } from 'src/table/table.module';
import { LangchainModule } from 'src/langchain/langchain.module';
import { UserModule } from 'src/user/user.module';
import { ConversationModule } from 'src/conversation/conversation.module';
import { OrderModule } from 'src/order/order.module';
import { TransactionModule } from 'src/transaction/transaction.module';
import { DatabaseModule } from 'src/db/db.module';
import { IPagModule } from 'src/payment-gateway/ipag.module';
import { CardModule } from 'src/card/card.module';
import { GenReceiptModule } from 'src/gen-receipt/gen.receipt.module';
import { MessageUtils } from './message.utils';
import { WhatsAppApiModule } from 'src/shared/whatsapp-api/whatsapp.api.module';
import { WhatsAppModule } from 'src/whatsapp/whatsapp.module';

@Module({
  imports: [
    TableModule, LangchainModule, UserModule, ConversationModule,
    OrderModule, TransactionModule, DatabaseModule, CardModule, forwardRef(() => IPagModule),
    GenReceiptModule,
    WhatsAppApiModule,
    forwardRef(() => WhatsAppModule)
  ],
  providers: [MessageService, MessageUtils],
  controllers: [MessageController],
  exports: [MessageUtils, MessageService],
})
export class MessageModule { }