import { Module } from '@nestjs/common';
import { IPagService } from './ipag.service';
import { IPagController } from './ipag.controller';
import { TransactionModule } from 'src/transaction/transaction.module';

@Module({
  providers: [IPagService],
  controllers: [IPagController],
  exports: [IPagService],
  imports: [TransactionModule]
})
export class IPagModule {}
