"""Adapters for third-party travel suppliers.

A package here owns ONE external system and is the only place that knows that
system's field names, quirks and error vocabulary. Everything above it —
services, routers, schemas — speaks JackPots shapes.

That boundary is the point. It means a supplier can be swapped, or a second one
added alongside, without a router or a template learning anything about it, and
it means a supplier's response can never reach a browser verbatim.
"""
