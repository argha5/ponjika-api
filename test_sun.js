const line1 = 'সূর্য উদয়: সকাল ০৫:১১:৪৪ এবং অস্ত: বিকাল ০৫:৫৭:৪১।';
const line2 = 'চন্দ্র উদয়: সকাল ১০:২১:২৪(২৩) এবং অস্ত: রাত্রি ১২:১৯:২৭(২৩)।';

// Test keyword matching
console.log('sun উদয় match:', line1.includes('উদয়'));
console.log('sun অস্ত match:', line1.includes('অস্ত'));
console.log('sun সূর্য match:', line1.includes('সূর্য'));
console.log('full sun match:', line1.includes('সূর্য') && line1.includes('উদয়') && line1.includes('অস্ত'));

console.log('moon চন্দ্র match:', line2.includes('চন্দ্র'));
console.log('moon উদয় match:', line2.includes('উদয়'));
console.log('moon অস্ত match:', line2.includes('অস্ত'));
console.log('full moon match:', line2.includes('চন্দ্র') && line2.includes('উদয়') && line2.includes('অস্ত'));
