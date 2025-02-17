import { Module } from '@nestjs/common';
import { GenReceiptService } from './gen.receipt.service';

@Module({
  providers: [GenReceiptService],
  exports: [GenReceiptService]
})
export class GenReceiptModule {}