process.title = 'stripe';
const E = '\x1b[';
const c = (n) => (s) => `${E}${n}m${s}${E}0m`;
const [g, r, y, b, dim] = [c(32), c(31), c(33), c(36), c(2)];
const types = [
    'charge.succeeded',
    'payment_intent.succeeded',
    'checkout.session.completed',
    'charge.refunded',
    'invoice.paid',
    'payment_intent.created',
    'customer.updated',
];
const id = (p) => p + Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString().slice(11, 19);
process.stdout.write(`${y('>')} Ready! Your webhook signing secret is ${b('whsec_4f9a…0e3f')} (^C to quit)\r\n`);
let n = 0;
const statuses = [200, 200, 200, 503, 200, 200, 200, 200, 500, 200, 200];
function tick() {
    const ev = id('evt_3Q');
    const t = types[n % types.length];
    const st = statuses[n % statuses.length];
    n++;
    process.stdout.write(`${now()}   --> ${t} [${dim(ev)}]\r\n`);
    setTimeout(
        () => {
            const code = st === 200 ? g(`[${st}]`) : r(`[${st}]`);
            process.stdout.write(`${now()}  <--  ${code} POST http://localhost:8080/webhooks/stripe\r\n`);
        },
        120 + Math.random() * 300,
    );
    setTimeout(tick, 900 + Math.random() * 2600);
}
setTimeout(tick, 600);
