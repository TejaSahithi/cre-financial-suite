import { describe, expect, it } from 'vitest';
import { buildCombinedVendors, vendorDisplayName } from '@/lib/vendors/vendorList';

describe('Vendors page vendor list model', () => {
  it('keeps DB vendor rows even when they are not linked to expense records', () => {
    const vendors = [
      { id: 'vendor-1', name: 'Austin Works', company: 'Austin Works' },
      { id: 'vendor-2', name: 'v-1', company: 'v-1' },
      { id: 'vendor-3', name: 'Roofing Co' },
      { id: 'vendor-4', name: 'Landscaping Co' },
      { id: 'vendor-5', name: 'Security Co' },
      { id: 'vendor-6', name: 'Cleaning Co' },
      { id: 'vendor-7', name: 'Plumbing Co' },
    ];
    const expenses = [
      { vendor: 'Austin Works', amount: 155800 },
      { vendor_name: 'v-1', amount: 21500 },
    ];

    const combined = buildCombinedVendors(vendors, expenses);

    expect(combined).toHaveLength(7);
    expect(combined.filter((vendor) => vendor.isSynthetic)).toHaveLength(0);
    expect(combined.map((vendor) => vendor.name)).toContain('Austin Works');
    expect(combined.map((vendor) => vendor.name)).toContain('Plumbing Co');
  });

  it('uses company/contact fallbacks for older vendor rows with a blank name', () => {
    expect(vendorDisplayName({ id: 'abc123456', name: '', company: 'Legacy Vendor LLC' })).toBe('Legacy Vendor LLC');
    expect(vendorDisplayName({ id: 'def123456', name: '', contact_email: 'vendor@example.com' })).toBe('vendor@example.com');
  });
});
