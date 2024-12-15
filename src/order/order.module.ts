import { Module } from '@nestjs/common';
import { DatabaseModule } from 'src/db/db.module';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

@Module({
  imports: [DatabaseModule],
  providers: [OrderService],
  controllers: [OrderController],
  exports: [OrderService],
})
export class OrderModule {}
