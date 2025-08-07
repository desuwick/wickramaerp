const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Data storage files
const ORDERS_FILE = 'orders.json';
const AUDIT_LOG = 'audit_log.csv';

// Initialize data files
function initializeFiles() {
    if (!fs.existsSync(ORDERS_FILE)) {
        fs.writeFileSync(ORDERS_FILE, JSON.stringify([]));
    }
    if (!fs.existsSync(AUDIT_LOG)) {
        fs.writeFileSync(AUDIT_LOG, 'timestamp,action,order_id,staff_name,details\n');
    }
}

// Generate unique order number (format: WRH-YYYYMMDD-XXX)
function generateOrderNumber() {
    const today = new Date();
    const day = today.getDate();           // e.g., 7
    const month = today.getMonth() + 1;    // e.g., 8 (August)
    const dateCode = `${day}${month.toString().padStart(2, '0')}`;  // "708"

    const orders = getOrders();
    const todayCode = `WHS-${dateCode}`;
    const todayOrders = orders.filter(order => order.order_number.startsWith(todayCode));
    const sequence = String(todayOrders.length + 1).padStart(2, '0');

    return `WHS-${dateCode}-${sequence}`;
}


// Load orders from file
function getOrders() {
    try {
        const data = fs.readFileSync(ORDERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

// Save orders to file
function saveOrders(orders) {
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// Log audit trail
function logAudit(action, orderId, staffName, details = '') {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp},${action},${orderId},${staffName},"${details}"\n`;
    fs.appendFileSync(AUDIT_LOG, logEntry);
}

// Serve customer tracking page
app.get('/track', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'track.html'));
});

// Customer order lookup API
app.get('/api/customer-lookup', (req, res) => {
    const { q } = req.query;
    const orders = getOrders();

    const order = orders.find(o =>
        o.order_number.toLowerCase() === q.toLowerCase() ||
        o.customer_phone.includes(q)
    );

    if (!order) return res.json({ found: false });

    res.json({
        found: true,
        order: {
            order_number: order.order_number,
            status: order.status,
            invoice_number: order.invoice_number,
            payment_method: order.payment_method,
            created_at: order.created_at
        }
    });
});

// Create new order
app.post('/api/orders', (req, res) => {
    const { customerName, customerPhone, items, paymentMethod, staffName } = req.body;
    const orderNumber = generateOrderNumber();
    const newOrder = {
        order_number: orderNumber,
        customer_name: customerName,
        customer_phone: customerPhone,
        items: items,
        payment_method: paymentMethod,
        invoice_number: '',
        status: 'received',
        created_at: new Date().toISOString(),
        created_by: staffName,
        approvals: [],
        status_history: [{
            status: 'received',
            timestamp: new Date().toISOString(),
            staff: staffName
        }]
    };

    const orders = getOrders();
    orders.push(newOrder);
    saveOrders(orders);
    logAudit('ORDER_CREATED', orderNumber, staffName, `Customer: ${customerName}`);

    res.json({ success: true, order_number: orderNumber });
});

// Get all orders
app.get('/api/orders', (req, res) => {
    const orders = getOrders();
    res.json(orders);
});

// Get single order
app.get('/api/orders/:orderNumber', (req, res) => {
    const orders = getOrders();
    const order = orders.find(o => o.order_number === req.params.orderNumber);
    if (!order) {
        return res.status(404).json({ error: 'Order not found' });
    }
    res.json(order);
});

// Update order status
app.put('/api/orders/:orderNumber/status', (req, res) => {
    const { status, staffName, invoiceNumber } = req.body;
    const orders = getOrders();
    const orderIndex = orders.findIndex(o => o.order_number === req.params.orderNumber);
    if (orderIndex === -1) return res.status(404).json({ error: 'Order not found' });

    const order = orders[orderIndex];
    order.status = status;
    if (invoiceNumber) order.invoice_number = invoiceNumber;

    order.status_history.push({
        status,
        timestamp: new Date().toISOString(),
        staff: staffName
    });

    orders[orderIndex] = order;
    saveOrders(orders);
    logAudit('STATUS_UPDATE', req.params.orderNumber, staffName, `Status: ${status}`);
    res.json({ success: true });
});

// Add approval
app.put('/api/orders/:orderNumber/approve', (req, res) => {
    const { staffName } = req.body;
    const orders = getOrders();
    const orderIndex = orders.findIndex(o => o.order_number === req.params.orderNumber);
    if (orderIndex === -1) return res.status(404).json({ error: 'Order not found' });

    const order = orders[orderIndex];
    if (order.approvals.find(a => a.staff === staffName)) {
        return res.status(400).json({ error: 'Staff member already approved this order' });
    }

    order.approvals.push({ staff: staffName, timestamp: new Date().toISOString() });

    if (order.approvals.length >= 3 && order.status === 'received') {
        order.status = 'approved';
        order.status_history.push({
            status: 'approved',
            timestamp: new Date().toISOString(),
            staff: 'SYSTEM'
        });
    }

    orders[orderIndex] = order;
    saveOrders(orders);
    logAudit('APPROVAL_ADDED', req.params.orderNumber, staffName, `Approval ${order.approvals.length}/3`);
    res.json({ success: true, approvals: order.approvals.length });
});

// Search orders
app.get('/api/search', (req, res) => {
    const { q, status } = req.query;
    let orders = getOrders();

    if (q) {
        orders = orders.filter(order =>
            order.customer_name.toLowerCase().includes(q.toLowerCase()) ||
            order.order_number.toLowerCase().includes(q.toLowerCase()) ||
            order.customer_phone.includes(q)
        );
    }

    if (status && status !== 'all') {
        orders = orders.filter(order => order.status === status);
    }

    res.json(orders);
});

// Export audit log
app.get('/api/export/audit', (req, res) => {
    try {
        const auditData = fs.readFileSync(AUDIT_LOG, 'utf8');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=audit_log.csv');
        res.send(auditData);
    } catch (error) {
        res.status(500).json({ error: 'Failed to export audit log' });
    }
});

// Dashboard stats
app.get('/api/stats', (req, res) => {
    const orders = getOrders();
    const today = new Date().toISOString().slice(0, 10);
    const stats = {
        total: orders.length,
        received: orders.filter(o => o.status === 'received').length,
        approved: orders.filter(o => o.status === 'approved').length,
        packed: orders.filter(o => o.status === 'packed').length,
        ready: orders.filter(o => o.status === 'ready').length,
        completed: orders.filter(o => o.status === 'completed').length,
        today: orders.filter(o => o.created_at.slice(0, 10) === today).length
    };
    res.json(stats);
});

// Initialize and start
initializeFiles();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Wick Ram Hardware Pickup System running on http://localhost:${PORT}`);
});
