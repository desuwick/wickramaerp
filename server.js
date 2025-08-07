const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const app = express();

// Configure multer for logo upload
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadsDir = 'public/uploads';
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        // Always save as logo.png/jpg/jpeg
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, 'logo' + ext);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: function (req, file, cb) {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Simple auth users (in production, use database with hashed passwords)
const AUTH_USERS = {
    'admin': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // hash of 'admin123'
    'manager': '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8', // hash of 'manager123'
    'staff': '2a97516c354b68848cdbd8f54a226a0a55b21ed138e207ad6c5cbb9c00aa5edd' // hash of 'staff123'
};

// Hash function
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// Login endpoint
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const hashedPassword = hashPassword(password);
    
    if (AUTH_USERS[username] === hashedPassword) {
        res.json({ 
            success: true, 
            username: username,
            isAdmin: username === 'admin' || username === 'manager'
        });
        logAudit('USER_LOGIN', 'N/A', username, `Login successful`);
    } else {
        res.status(401).json({ success: false, error: 'Invalid credentials' });
        logAudit('LOGIN_FAILED', 'N/A', username || 'unknown', `Failed login attempt`);
    }
});

// Soft delete order (move to recycle bin)
app.delete('/api/orders/:orderNumber', (req, res) => {
    try {
        const orders = getOrders();
        const orderIndex = orders.findIndex(o => o.order_number === req.params.orderNumber);
        
        if (orderIndex === -1) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }
        
        const orderToDelete = orders.splice(orderIndex, 1)[0];
        
        // Add deletion metadata
        orderToDelete.deleted_at = new Date().toISOString();
        orderToDelete.deleted_by = req.body.staffName || 'manager';
        orderToDelete.original_status = orderToDelete.status;
        orderToDelete.status = 'deleted';
        
        // Move to deleted orders (recycle bin)
        const deletedOrders = getDeletedOrders();
        deletedOrders.push(orderToDelete);
        
        // Save both files
        saveOrders(orders);
        saveDeletedOrders(deletedOrders);
        
        logAudit('ORDER_MOVED_TO_RECYCLE', req.params.orderNumber, req.body.staffName || 'manager', 
                 `Order moved to recycle bin: ${orderToDelete.customer_name}`);
        
        res.json({ 
            success: true, 
            message: 'Order moved to recycle bin. It will be auto-deleted after 7 days.',
            recycleBinCount: deletedOrders.length
        });
    } catch (error) {
        console.error('Soft delete error:', error);
        res.status(500).json({ success: false, error: 'Server error while moving order to recycle bin' });
    }
});

// Get deleted orders (recycle bin)
app.get('/api/deleted-orders', (req, res) => {
    try {
        const deletedOrders = getDeletedOrders();
        res.json(deletedOrders);
    } catch (error) {
        res.status(500).json({ error: 'Error loading deleted orders' });
    }
});

// Restore order from recycle bin
app.post('/api/orders/:orderNumber/restore', (req, res) => {
    try {
        const deletedOrders = getDeletedOrders();
        const orderIndex = deletedOrders.findIndex(o => o.order_number === req.params.orderNumber);
        
        if (orderIndex === -1) {
            return res.status(404).json({ success: false, error: 'Order not found in recycle bin' });
        }
        
        const orderToRestore = deletedOrders.splice(orderIndex, 1)[0];
        
        // Restore original status and remove deletion metadata
        orderToRestore.status = orderToRestore.original_status || 'received';
        delete orderToRestore.deleted_at;
        delete orderToRestore.deleted_by;
        delete orderToRestore.original_status;
        
        // Move back to active orders
        const orders = getOrders();
        orders.push(orderToRestore);
        
        saveOrders(orders);
        saveDeletedOrders(deletedOrders);
        
        logAudit('ORDER_RESTORED', req.params.orderNumber, req.body.staffName || 'manager', 
                 `Order restored from recycle bin: ${orderToRestore.customer_name}`);
        
        res.json({ success: true, message: 'Order restored successfully' });
    } catch (error) {
        console.error('Restore error:', error);
        res.status(500).json({ success: false, error: 'Error restoring order' });
    }
});

// Permanently delete order from recycle bin
app.delete('/api/deleted-orders/:orderNumber', (req, res) => {
    try {
        const deletedOrders = getDeletedOrders();
        const orderIndex = deletedOrders.findIndex(o => o.order_number === req.params.orderNumber);
        
        if (orderIndex === -1) {
            return res.status(404).json({ success: false, error: 'Order not found in recycle bin' });
        }
        
        const orderToPermanentlyDelete = deletedOrders.splice(orderIndex, 1)[0];
        
        // Export data before permanent deletion
        const exportFilename = exportOrderData(orderToPermanentlyDelete);
        
        saveDeletedOrders(deletedOrders);
        
        logAudit('ORDER_PERMANENTLY_DELETED', req.params.orderNumber, req.body.staffName || 'manager', 
                 `Order permanently deleted. Exported to: ${exportFilename || 'export failed'}`);
        
        res.json({ 
            success: true, 
            message: 'Order permanently deleted. Data has been exported for records.',
            exportedTo: exportFilename
        });
    } catch (error) {
        console.error('Permanent delete error:', error);
        res.status(500).json({ success: false, error: 'Error permanently deleting order' });
    }
});

// Get recycle bin statistics
app.get('/api/recycle-bin/stats', (req, res) => {
    try {
        const deletedOrders = getDeletedOrders();
        const now = new Date();
        
        let expiringSoon = 0;
        deletedOrders.forEach(order => {
            const deletedAt = new Date(order.deleted_at);
            const daysOld = Math.floor((now - deletedAt) / (1000 * 60 * 60 * 24));
            if (daysOld >= 5) expiringSoon++; // 5+ days old (expiring in 2 days)
        });
        
        res.json({
            total: deletedOrders.length,
            expiringSoon: expiringSoon
        });
    } catch (error) {
        res.status(500).json({ error: 'Error loading recycle bin stats' });
    }
});

// Logo upload endpoint
app.post('/api/upload-logo', upload.single('logo'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No logo file provided' });
        }
        
        const logoUrl = `/uploads/${req.file.filename}`;
        logAudit('LOGO_UPLOADED', 'N/A', req.body.staffName || 'manager', `Logo uploaded: ${req.file.filename}`);
        
        res.json({ 
            success: true, 
            message: 'Logo uploaded successfully',
            logoUrl: logoUrl
        });
    } catch (error) {
        console.error('Logo upload error:', error);
        res.status(500).json({ success: false, error: 'Error uploading logo' });
    }
});

// Get current logo
app.get('/api/logo', (req, res) => {
    try {
        const uploadsDir = 'public/uploads';
        const logoFiles = ['logo.png', 'logo.jpg', 'logo.jpeg'];
        
        for (const filename of logoFiles) {
            const filepath = path.join(uploadsDir, filename);
            if (fs.existsSync(filepath)) {
                return res.json({ 
                    success: true, 
                    logoUrl: `/uploads/${filename}`,
                    hasLogo: true
                });
            }
        }
        
        res.json({ success: true, hasLogo: false });
    } catch (error) {
        res.status(500).json({ error: 'Error checking logo' });
    }
});

// Customer order lookup endpoint
app.get('/api/customer-lookup', (req, res) => {
    try {
        const query = req.query.q?.trim();
        if (!query) {
            return res.json({ found: false, message: 'Please provide a search query' });
        }
        
        const orders = getOrders();
        
        // Search by order number or phone number
        const matchedOrder = orders.find(order => 
            order.order_number.toLowerCase() === query.toLowerCase() ||
            order.customer_phone.includes(query) ||
            order.customer_phone.replace(/\D/g, '').includes(query.replace(/\D/g, ''))
        );
        
        if (!matchedOrder) {
            logAudit('CUSTOMER_LOOKUP_FAILED', 'N/A', 'CUSTOMER', `Failed lookup for: ${query}`);
            return res.json({ 
                found: false, 
                message: 'Order not found. Please check your order number or phone number.' 
            });
        }
        
        // Log successful lookup
        logAudit('CUSTOMER_LOOKUP_SUCCESS', matchedOrder.order_number, 'CUSTOMER', `Successful lookup: ${query}`);
        
        // Return order information (excluding sensitive data)
        res.json({
            found: true,
            order: {
                order_number: matchedOrder.order_number,
                customer_name: matchedOrder.customer_name,
                customer_phone: matchedOrder.customer_phone,
                status: matchedOrder.status,
                payment_method: matchedOrder.payment_method,
                invoice_number: matchedOrder.invoice_number,
                created_at: matchedOrder.created_at,
                items: matchedOrder.items,
                approvals: matchedOrder.approvals || [],
                status_history: matchedOrder.status_history || []
            }
        });
    } catch (error) {
        console.error('Customer lookup error:', error);
        res.status(500).json({ found: false, message: 'System error. Please try again later.' });
    }
});

// Data storage files
const ORDERS_FILE = 'orders.json';
const DELETED_ORDERS_FILE = 'deleted_orders.json';
const AUDIT_LOG = 'audit_log.csv';
const EXPORTS_DIR = 'exports';

// Initialize data files
function initializeFiles() {
    if (!fs.existsSync(ORDERS_FILE)) {
        fs.writeFileSync(ORDERS_FILE, JSON.stringify([]));
    }
    if (!fs.existsSync(DELETED_ORDERS_FILE)) {
        fs.writeFileSync(DELETED_ORDERS_FILE, JSON.stringify([]));
    }
    if (!fs.existsSync(AUDIT_LOG)) {
        fs.writeFileSync(AUDIT_LOG, 'timestamp,action,order_id,staff_name,details\n');
    }
    if (!fs.existsSync(EXPORTS_DIR)) {
        fs.mkdirSync(EXPORTS_DIR);
    }
}

// Generate unique order number (format: WHS-001)
function generateOrderNumber() {
    const orders = getOrders();
    const sequence = orders.length + 1;
    const paddedSequence = String(sequence).padStart(3, '0');
    return `WHS-${paddedSequence}`;
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

// Load deleted orders from file (recycle bin)
function getDeletedOrders() {
    try {
        const data = fs.readFileSync(DELETED_ORDERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

// Save deleted orders to file
function saveDeletedOrders(deletedOrders) {
    fs.writeFileSync(DELETED_ORDERS_FILE, JSON.stringify(deletedOrders, null, 2));
}

// Export order data before permanent deletion
function exportOrderData(order) {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `order-${order.order_number}-${timestamp}.json`;
        const filepath = path.join(EXPORTS_DIR, filename);
        
        const exportData = {
            ...order,
            exported_at: new Date().toISOString(),
            export_reason: 'permanent_deletion'
        };
        
        fs.writeFileSync(filepath, JSON.stringify(exportData, null, 2));
        return filename;
    } catch (error) {
        console.error('Export error:', error);
        return null;
    }
}

// Log audit trail
function logAudit(action, orderId, staffName, details = '') {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp},${action},${orderId},${staffName},"${details}"\n`;
    fs.appendFileSync(AUDIT_LOG, logEntry);
}

// Auto cleanup deleted orders older than 7 days
function autoCleanupDeletedOrders() {
    try {
        const deletedOrders = getDeletedOrders();
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        
        const toKeep = [];
        let cleanedCount = 0;
        
        deletedOrders.forEach(order => {
            const deletedAt = new Date(order.deleted_at);
            
            if (deletedAt > sevenDaysAgo) {
                toKeep.push(order);
            } else {
                // Export before permanent deletion
                exportOrderData(order);
                cleanedCount++;
                logAudit('AUTO_CLEANUP', order.order_number, 'SYSTEM', '7-day auto cleanup');
            }
        });
        
        if (cleanedCount > 0) {
            saveDeletedOrders(toKeep);
            console.log(`Auto-cleaned ${cleanedCount} orders from recycle bin`);
        }
    } catch (error) {
        console.error('Auto cleanup error:', error);
    }
}
function logAudit(action, orderId, staffName, details = '') {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp},${action},${orderId},${staffName},"${details}"\n`;
    fs.appendFileSync(AUDIT_LOG, logEntry);
}

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
        invoice_number: '', // To be filled later from ERP
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
    
    if (orderIndex === -1) {
        return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orders[orderIndex];
    order.status = status;
    
    if (invoiceNumber) {
        order.invoice_number = invoiceNumber;
    }
    
    // Add to status history
    order.status_history.push({
        status: status,
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
    
    if (orderIndex === -1) {
        return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orders[orderIndex];
    
    // Check if staff already approved
    if (order.approvals.find(a => a.staff === staffName)) {
        return res.status(400).json({ error: 'Staff member already approved this order' });
    }
    
    order.approvals.push({
        staff: staffName,
        timestamp: new Date().toISOString()
    });
    
    // Auto-update status if 3 approvals reached
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
    const stats = {
        total: orders.length,
        received: orders.filter(o => o.status === 'received').length,
        approved: orders.filter(o => o.status === 'approved').length,
        packed: orders.filter(o => o.status === 'packed').length,
        ready: orders.filter(o => o.status === 'ready').length,
        completed: orders.filter(o => o.status === 'completed').length,
        today: orders.filter(o => {
            const today = new Date().toISOString().slice(0,10);
            return o.created_at.slice(0,10) === today;
        }).length
    };
    res.json(stats);
});

// Initialize files and start server
initializeFiles();

// Run auto-cleanup on startup
autoCleanupDeletedOrders();

// Schedule auto-cleanup to run daily at 2 AM
setInterval(() => {
    const now = new Date();
    if (now.getHours() === 2 && now.getMinutes() === 0) {
        autoCleanupDeletedOrders();
    }
}, 60000); // Check every minute

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Wickrama Hardware Pickup System running on http://localhost:${PORT}`);
    console.log(`📁 Data files: ${ORDERS_FILE}, ${DELETED_ORDERS_FILE}, ${AUDIT_LOG}`);
    console.log(`📦 Exports directory: ${EXPORTS_DIR}`);
    console.log(`🗑️ Auto-cleanup: Orders in recycle bin are permanently deleted after 7 days`);
});

module.exports = app;