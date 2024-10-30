import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { WhatsAppController } from './whatsapp/whatsapp.controller';
import { WhatsAppService } from './whatsapp/whatsapp.service';
import { TableModule } from './table/table.module';
import { LangchainModule } from './langchain/langchain.module';

@Module({
  imports: [WhatsAppModule, TableModule, LangchainModule],
  controllers: [AppController, WhatsAppController],
  providers: [AppService, WhatsAppService],
})
export class AppModule { }
