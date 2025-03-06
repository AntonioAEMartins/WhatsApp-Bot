import { Module } from '@nestjs/common';
import { DatabaseModule } from 'src/db/db.module';
import { TransactionController } from './transaction.controller';
import { TransactionService } from './transaction.service';
import { IPagModule } from 'src/payment-gateway/ipag.module';

@Module({
  imports: [DatabaseModule],
  providers: [TransactionService],
  controllers: [TransactionController],
  exports: [TransactionService],
})
export class TransactionModule {}
