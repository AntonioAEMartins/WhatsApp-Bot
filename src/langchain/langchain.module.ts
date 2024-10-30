// src/langchain/langchain.module.ts
import { Module } from '@nestjs/common';
import { LangchainService } from './langchain.service';
import { LangchainController } from './langchain.controller';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  controllers: [LangchainController],
  providers: [LangchainService],
})
export class LangchainModule {}
