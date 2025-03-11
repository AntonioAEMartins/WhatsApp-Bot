import { Module, forwardRef } from '@nestjs/common';
import { IPagService } from './ipag.service';
import { IPagController } from './ipag.controller';
import { TransactionModule } from 'src/transaction/transaction.module';
import { ConversationModule } from 'src/conversation/conversation.module';
import { CardModule } from 'src/card/card.module';
import { MessageModule } from 'src/message/message.module';

@Module({
  providers: [IPagService],
  controllers: [IPagController],
  exports: [IPagService],
  imports: [
    TransactionModule,
    ConversationModule,
    CardModule,
    forwardRef(() => MessageModule),
  ]
})
export class IPagModule { }
