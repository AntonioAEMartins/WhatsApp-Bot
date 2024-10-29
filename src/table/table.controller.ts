import { Controller, Param, Post } from '@nestjs/common';
import { TableService } from './table.service';

@Controller('table')
export class TableController {
    constructor(private readonly tableService: TableService) { }

    @Post("order/:id")
    orderTable(@Param('id') id: number): Promise<string> {
        return this.tableService.orderTable(id);
    }

}
