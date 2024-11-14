import { Injectable } from '@nestjs/common';

@Injectable()
export class TableService {

    private readonly url: string;

    constructor() {
        this.url = process.env.POS_BACKEND_URL;
        console.log('TableService URL:', this.url);
    }

    async orderTable(id: number): Promise<any> {

        const response = await fetch(`${this.url}/order`, {
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

        const response = await fetch(`${this.url}/payment`, {
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

        const response = await fetch(`${this.url}/close`, {
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

        const response = await fetch(`${this.url}/message`, {
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
