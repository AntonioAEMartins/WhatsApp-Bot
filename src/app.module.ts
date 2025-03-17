import { MiddlewareConsumer, Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TableModule } from './table/table.module';
import { DatabaseModule } from './db/db.module';
import { ConversationModule } from './conversation/conversation.module';
import { UserModule } from './user/user.module';
import { TransactionModule } from './transaction/transaction.module';
import { OrderModule } from './order/order.module';
import { IPagModule } from './payment-gateway/ipag.module';
import { ScheduleModule } from '@nestjs/schedule';
import { CardModule } from './card/card.module';
import { MessageModule } from './message/message.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { RequestLoggerMiddleware } from './middleware/incoming-requests.middleware';
import { WhatsAppApiModule } from './shared/whatsapp-api/whatsapp.api.module';

@Module({
  imports: [
    MessageModule,
    TableModule,
    DatabaseModule,
    ConversationModule,
    UserModule,
    TransactionModule,
    OrderModule,
    IPagModule,
    ScheduleModule.forRoot(),
    CardModule,
    WhatsAppModule,
    WhatsAppApiModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestLoggerMiddleware)
      .forRoutes('*');
  }
}


