import { Injectable } from '@nestjs/common';

@Injectable()
export class TableService {

    async orderTable(id: number): Promise<any> {

        const response = await fetch(`http://100.125.76.9:8000/order`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ table_id: id }),
        });


        if (!response.ok) {
            throw new Error('Failed to order table');
        }

        return await response.json();
    }

    async startPayment(id: number): Promise<any> {

        const response = await fetch(`http://100.125.76.9:8000/payment`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ table_id: id }),
        });

        if (!response.ok) {
            throw new Error('Failed to start payment');
        }

        return await response.json();
    }

    async finishPayment(id: number): Promise<any> {

        const response = await fetch(`http://100.125.76.9:8000/close`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ table_id: id }),
        });

        if (!response.ok) {
            throw new Error('Failed to finish payment');
        }

        return await response.json();
    }

    async orderMessage(id: number): Promise<any> {

        const response = await fetch(`http://100.125.76.9:8000/message`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ table_id: id }),
        });


        if (!response.ok) {
            throw new Error('Failed to order table');
        }

        return await response.json();
    }

}
