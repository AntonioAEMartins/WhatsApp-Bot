import { Test, TestingModule } from '@nestjs/testing';
import { TableService } from './table.service';
import { TableController } from './table.controller';
import { TableModule } from './table.module';

describe('TableService', () => {
  let service: TableService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TableService],  // Add TableService as a provider here
    }).compile();

    service = module.get<TableService>(TableService);  // Get the service from the module
  });

  it('should be defined', () => {
    expect(service).toBeDefined();  // This should now pass as the service is defined
  });
});
