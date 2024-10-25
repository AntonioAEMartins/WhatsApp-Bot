import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service'; // Import the service

describe('WhatsAppController', () => {
  let controller: WhatsAppController;
  let service: WhatsAppService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WhatsAppController],
      providers: [
        {
          provide: WhatsAppService, // Mock the WhatsAppService
          useValue: {
            someFunction: jest.fn(), // Mock any functions the controller might call
          },
        },
      ],
    }).compile();

    controller = module.get<WhatsAppController>(WhatsAppController);
    service = module.get<WhatsAppService>(WhatsAppService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
