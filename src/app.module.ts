import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { TableModule } from './table/table.module';
import { LangchainModule } from './langchain/langchain.module';
import { DatabaseModule } from './db/db.module';
import { ConversationModule } from './conversation/conversation.module';
import { UserModule } from './user/user.module';
import { TransactionModule } from './transaction/transaction.module';
import { OrderModule } from './order/order.module';
import { IPagModule } from './payment-gateway/ipag.module';
import { ScheduleModule } from '@nestjs/schedule';
import { CardModule } from './card/card.module';

@Module({
  imports: [
    WhatsAppModule,
    TableModule,
    LangchainModule,
    DatabaseModule,
    ConversationModule,
    UserModule,
    TransactionModule,
    OrderModule,
    IPagModule,
    ScheduleModule.forRoot(),
    CardModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
