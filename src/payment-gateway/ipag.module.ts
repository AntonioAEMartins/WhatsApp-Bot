import { Module, forwardRef } from '@nestjs/common';
import { IPagService } from './ipag.service';
import { IPagController } from './ipag.controller';
import { TransactionModule } from 'src/transaction/transaction.module';
import { ConversationModule } from 'src/conversation/conversation.module';
import { CardModule } from 'src/card/card.module';
import { WhatsAppModule } from 'src/whatsapp/whatsapp.module';

@Module({
  providers: [IPagService],
  controllers: [IPagController],
  exports: [IPagService],
  imports: [
    TransactionModule,
    ConversationModule,
    CardModule,
    forwardRef(() => WhatsAppModule),
  ]
})
export class IPagModule { }
