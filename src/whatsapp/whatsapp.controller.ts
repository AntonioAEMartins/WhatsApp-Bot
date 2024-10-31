// src/whatsapp/whatsapp.controller.ts

import { Controller, Get } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { Message } from 'whatsapp-web.js';


@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsappService: WhatsAppService) { }

  @Get('status')
  getStatus(): string {
    // You can enhance this method to return actual status from the service
    return 'WhatsApp Client is running.';
  }

  @Get('test_contacts')
  async testContacts(): Promise<any> {
    const from = '5511971143177@c.us';
    const state = {
      step: 'waiting_for_contacts',
      numPeople: 2,
      orderDetails:{
        total: 100,
      },
      receivedContacts: 0, // Initialize receivedContacts
      contacts: [],        // Initialize contacts array
    };

    // Mock message object with a vCard
    const message: Message = {
      type: 'vcard',
      vCards: [
        `BEGIN:VCARD
  VERSION:3.0
  FN:Test User
  TEL;type=CELL;waid=5511987654321:+55 11 98765-4321
  END:VCARD`,
      ],
      hasMedia: false,
      from: from,
      // Include any other necessary properties if needed
    } as any; // Casting to 'any' to satisfy TypeScript compiler

    // Manually set the state in the clientStates map
    this.whatsappService['clientStates'].set(from, state);

    // Call the handleWaitingForContacts method
    const result = await this.whatsappService['handleWaitingForContacts'](from, state, message);

    return result; // Return the messages sent
  }


  // Additional endpoints can be added here as needed
}
