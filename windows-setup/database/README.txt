Put your database export file(s) here, e.g. library.sql
(export from phpMyAdmin or: mysqldump -u root -p --default-character-set=utf8 library > library.sql)

The installer imports every *.sql file here (sorted by name) into the database
set by DB_NAME in config.ini - only when that database is still empty.
