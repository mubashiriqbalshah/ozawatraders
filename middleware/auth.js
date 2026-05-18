function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    return res.redirect('/admin/login');
}

function injectUser(req, res, next) {
    res.locals.currentUser = (req.session && req.session.user) || null;
    next();
}

module.exports = { requireAuth, injectUser };
