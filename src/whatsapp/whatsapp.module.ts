import { Module, forwardRef } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';
import { TableModule } from 'src/table/table.module';
import { LangchainModule } from 'src/langchain/langchain.module';
import { UserModule } from 'src/user/user.module';
import { ConversationModule } from 'src/conversation/conversation.module';
import { OrderModule } from 'src/order/order.module';
import { TransactionModule } from 'src/transaction/transaction.module';
import { WhatsAppUtils } from './whatsapp.utils';
import { DatabaseModule } from 'src/db/db.module';
import { IPagModule } from 'src/payment-gateway/ipag.module';
import { CardModule } from 'src/card/card.module';
import { GenReceiptModule } from 'src/gen-receipt/gen.receipt.module';
@Module({
  imports: [
    TableModule, LangchainModule, UserModule, ConversationModule,
    OrderModule, TransactionModule, DatabaseModule, forwardRef(() => IPagModule),
    CardModule,
    GenReceiptModule
  ],
  providers: [WhatsAppService, WhatsAppUtils],
  controllers: [WhatsAppController],
  providers: [WhatsAppService, MessageProcessor],
  exports: [WhatsAppService],
})
export class WhatsAppModule { }
