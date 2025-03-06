import { Module } from '@nestjs/common';
import { IPagService } from './ipag.service';
import { IPagController } from './ipag.controller';
import { TransactionModule } from 'src/transaction/transaction.module';
import { BullModule } from '@nestjs/bull';
import { ConversationModule } from 'src/conversation/conversation.module';
import { CardModule } from 'src/card/card.module';
@Module({
  providers: [IPagService],
  controllers: [IPagController],
  exports: [IPagService],
  imports: [TransactionModule, ConversationModule, BullModule.forRoot({
    redis: {
      host: 'localhost',
      port: 6379,
    },
  }),
    BullModule.registerQueue({
      name: 'payment',
    }),
    CardModule,
  ]
})
export class IPagModule { }
