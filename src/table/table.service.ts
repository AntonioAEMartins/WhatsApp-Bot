import { Injectable } from '@nestjs/common';

@Injectable()
export class TableService {

    private readonly url: string;

    constructor() {
        this.url = process.env.POS_BACKEND_URL;
    }

    async orderTable(id: number): Promise<any> {

        const response = await fetch(`${this.url}/tables/${id}`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });


        if (!response.ok) {
            throw new Error('Failed to order table');
        }

        return await response.json();
    }

    async startPayment(id: number): Promise<any> {

        const response = await fetch(`${this.url}/tables/${id}/payment`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        console.log("Start Payment Response: ", response);

        if (!response.ok) {
            throw new Error('Failed to start payment');
        }

        return await response.json();
    }

    async finishPayment(id: number): Promise<any> {

        const response = await fetch(`${this.url}/tables/${id}/close`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error('Failed to finish payment');
        }

        return await response.json();
    }

    async orderMessage(id: number): Promise<any> {

        const response = await fetch(`${this.url}/tables/${id}/message`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            },
        });


        if (!response.ok) {
            throw new Error('Failed to order table');
        }

        return await response.json();
    }

}
