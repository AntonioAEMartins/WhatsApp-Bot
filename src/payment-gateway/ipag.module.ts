import { Module } from '@nestjs/common';
import { IPagService } from './ipag.service';
import { IPagController } from './ipag.controller';

@Module({
  providers: [IPagService],
  controllers: [IPagController],
  exports: [IPagService],
})
export class IPagModule {}
