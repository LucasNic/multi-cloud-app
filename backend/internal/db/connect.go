package db

import (
	"database/sql"
	"fmt"

	_ "github.com/lib/pq"
)

func Connect(dsn string) (*sql.DB, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("sql.Open: %w", err)
	}
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("db.Ping: %w", err)
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	return db, nil
}

func Migrate(db *sql.DB) error {
	migrations := []string{
		`CREATE TABLE IF NOT EXISTS requests (
			id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			trace_id   STRING NOT NULL,
			status     STRING NOT NULL,
			cluster    STRING NOT NULL,
			created_at TIMESTAMPTZ DEFAULT now()
		)`,
		`CREATE TABLE IF NOT EXISTS cluster_state (
			cluster    STRING PRIMARY KEY,
			is_down    BOOL NOT NULL DEFAULT false,
			down_until TIMESTAMPTZ,
			updated_at TIMESTAMPTZ DEFAULT now()
		)`,
	}
	for _, m := range migrations {
		if _, err := db.Exec(m); err != nil {
			return err
		}
	}
	return nil
}
