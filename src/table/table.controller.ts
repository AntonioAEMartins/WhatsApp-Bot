import { Controller, Param, Post } from '@nestjs/common';
import { TableService } from './table.service';

@Controller('table')
export class TableController {
    constructor(private readonly tableService: TableService) { }

    @Post("order/:id")
    orderTable(@Param('id') id: number): Promise<string> {
        return this.tableService.orderTable(id);
    }

    @Post("payment/start/:id")
    startPayment(@Param('id') id: number): Promise<string> {
        return this.tableService.startPayment(id);
    }

    @Post("payment/finish/:id")
    finishPayment(@Param('id') id: number): Promise<string> {
        return this.tableService.finishPayment(id);
    }

}
