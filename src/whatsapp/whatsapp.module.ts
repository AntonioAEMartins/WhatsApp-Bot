import { Module } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';
import { TableModule } from 'src/table/table.module';
import { LangchainModule } from 'src/langchain/langchain.module';
import { UserModule } from 'src/user/user.module';
import { ConversationModule } from 'src/conversation/conversation.module';
import { OrderModule } from 'src/order/order.module';
import { TransactionModule } from 'src/transaction/transaction.module';
import { WhatsAppUtils } from './whatsapp.utils.service';

@Module({
  imports: [TableModule, LangchainModule, UserModule, ConversationModule, OrderModule, TransactionModule],
  providers: [WhatsAppService, WhatsAppUtils],
  controllers: [WhatsAppController],
  exports: [WhatsAppUtils],
})
export class WhatsAppModule {}
